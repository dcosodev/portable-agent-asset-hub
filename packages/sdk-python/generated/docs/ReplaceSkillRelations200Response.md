# ReplaceSkillRelations200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**body** | **str** | UTF-8 body bytes serialized as a JSON string. |
**body_sha256** | **str** |  |
**created_at** | **str** |  |
**id** | **str** |  |
**kind** | **str** |  |
**lifecycle** | **str** |  |
**logical_key** | **str** |  |
**metadata** | **object** |  |
**name** | **str** |  |
**resources** | [**List[ReplaceSkillRelations200ResponseResourcesInner]**](ReplaceSkillRelations200ResponseResourcesInner.md) |  |
**scope** | [**ReplaceSkillRelations200ResponseScope**](ReplaceSkillRelations200ResponseScope.md) |  |
**summary** | **str** |  | [optional]
**total_size** | **int** |  |
**updated_at** | **str** |  |
**version** | **int** |  |

## Example

```python
from openapi_client.models.replace_skill_relations200_response import ReplaceSkillRelations200Response

# TODO update the JSON string below
json = "{}"
# create an instance of ReplaceSkillRelations200Response from a JSON string
replace_skill_relations200_response_instance = ReplaceSkillRelations200Response.from_json(json)
# print the JSON string representation of the object
print(ReplaceSkillRelations200Response.to_json())

# convert the object into a dict
replace_skill_relations200_response_dict = replace_skill_relations200_response_instance.to_dict()
# create an instance of ReplaceSkillRelations200Response from a dict
replace_skill_relations200_response_from_dict = ReplaceSkillRelations200Response.from_dict(replace_skill_relations200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
