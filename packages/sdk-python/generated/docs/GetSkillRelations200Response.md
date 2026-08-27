# GetSkillRelations200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**items** | [**List[SkillRelation]**](SkillRelation.md) |  |

## Example

```python
from openapi_client.models.get_skill_relations200_response import GetSkillRelations200Response

# TODO update the JSON string below
json = "{}"
# create an instance of GetSkillRelations200Response from a JSON string
get_skill_relations200_response_instance = GetSkillRelations200Response.from_json(json)
# print the JSON string representation of the object
print(GetSkillRelations200Response.to_json())

# convert the object into a dict
get_skill_relations200_response_dict = get_skill_relations200_response_instance.to_dict()
# create an instance of GetSkillRelations200Response from a dict
get_skill_relations200_response_from_dict = GetSkillRelations200Response.from_dict(get_skill_relations200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
