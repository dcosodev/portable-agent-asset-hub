# GetSkill200Response


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
**resources** | [**List[SearchSkills200ResponseItemsInnerResourcesInner]**](SearchSkills200ResponseItemsInnerResourcesInner.md) |  |
**scope** | [**SearchSkills200ResponseItemsInnerScope**](SearchSkills200ResponseItemsInnerScope.md) |  |
**summary** | **str** |  | [optional]
**total_size** | **int** |  |
**updated_at** | **str** |  |
**version** | **int** |  |

## Example

```python
from openapi_client.models.get_skill200_response import GetSkill200Response

# TODO update the JSON string below
json = "{}"
# create an instance of GetSkill200Response from a JSON string
get_skill200_response_instance = GetSkill200Response.from_json(json)
# print the JSON string representation of the object
print(GetSkill200Response.to_json())

# convert the object into a dict
get_skill200_response_dict = get_skill200_response_instance.to_dict()
# create an instance of GetSkill200Response from a dict
get_skill200_response_from_dict = GetSkill200Response.from_dict(get_skill200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
