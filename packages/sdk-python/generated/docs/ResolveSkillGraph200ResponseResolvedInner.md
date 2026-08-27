# ResolveSkillGraph200ResponseResolvedInner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**constraint** | **str** |  |
**depth** | **int** |  |
**parent** | [**ResolveSkillGraph200ResponseResolvedInnerParent**](ResolveSkillGraph200ResponseResolvedInnerParent.md) |  |
**relation** | **str** |  |
**resolved_version** | **int** |  |
**skill_id** | **str** |  |
**version** | **int** |  |

## Example

```python
from openapi_client.models.resolve_skill_graph200_response_resolved_inner import ResolveSkillGraph200ResponseResolvedInner

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveSkillGraph200ResponseResolvedInner from a JSON string
resolve_skill_graph200_response_resolved_inner_instance = ResolveSkillGraph200ResponseResolvedInner.from_json(json)
# print the JSON string representation of the object
print(ResolveSkillGraph200ResponseResolvedInner.to_json())

# convert the object into a dict
resolve_skill_graph200_response_resolved_inner_dict = resolve_skill_graph200_response_resolved_inner_instance.to_dict()
# create an instance of ResolveSkillGraph200ResponseResolvedInner from a dict
resolve_skill_graph200_response_resolved_inner_from_dict = ResolveSkillGraph200ResponseResolvedInner.from_dict(resolve_skill_graph200_response_resolved_inner_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
